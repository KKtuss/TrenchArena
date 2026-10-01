'use client';

import Link from 'next/link';

import { TrainerName } from '@/components/profile-trainer';
import { Badge, Panel } from '@/components/shell';
import { formatPoke, formatRoomAmount } from '@/lib/api-client';
import type {
  CasualEconomicsPreview,
  CasualRoom,
  TournamentEconomicsPreview,
  TournamentSummary,
} from '@/lib/protocol';

function formatLabel(format: string, battleSize?: string, ruleset?: string): string {
  if (ruleset === 'competitive') return 'Competitive · Gen 9 OU';
  if (battleSize === '1v1') return 'Casual 6 → 3';
  const pretty = format === 'gen9ou' ? 'Gen 9 OU' : format.toUpperCase();
  return battleSize ? `${pretty} · ${battleSize}` : pretty;
}

function statusTone(status: string): 'default' | 'live' | 'success' | 'danger' {
  if (status === 'battling' || status === 'active' || status === 'ready' || status === 'in-progress' || status === 'registration') return 'live';
  if (status === 'completed') return 'success';
  if (status === 'cancelled' || status === 'forfeited') return 'danger';
  if (status === 'tied') return 'default';
  return 'default';
}

function isSettledEvent(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'forfeited' || status === 'tied';
}

function eventFieldLabel(tournament: TournamentSummary): { label: string; value: string } {
  if (isSettledEvent(tournament.status)) {
    return { label: 'Field', value: `${tournament.playerCount} entered` };
  }
  if (tournament.status === 'in-progress' || tournament.status === 'active' || tournament.status === 'ready') {
    return { label: 'Field', value: `${tournament.playerCount} competing` };
  }
  return { label: 'Registering', value: `${tournament.playerCount}/${tournament.maxPlayers}` };
}

function eventStatusLabel(tournament: TournamentSummary): string {
  if (tournament.status === 'completed') return tournament.winner ? 'Crown awarded' : 'Completed';
  if (tournament.status === 'registration') return 'Registration';
  if (tournament.status === 'ready') return 'Ready to start';
  if (tournament.status === 'in-progress' || tournament.status === 'active') return 'Bracket live';
  if (tournament.status === 'draft') return 'Draft';
  return tournament.status;
}

function TrainerFigure({ foe, size = 'sm' }: { foe?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const cap = foe ? '#8a2834' : '#163a68';
  const brim = foe ? '#1a0c10' : '#0b192b';
  const coat = foe ? '#7a2430' : '#1c4a86';
  const collar = foe ? '#2a1014' : '#0b192b';
  const accent = foe ? '#ff7466' : '#35a7ff';
  return (
    <svg
      className={`trainer-figure trainer-figure-${size}`}
      viewBox="0 0 64 96"
      aria-hidden
    >
      <ellipse cx="32" cy="12" rx="16" ry="5" fill={brim} />
      <rect x="18" y="4" width="28" height="10" rx="3" fill={cap} />
      <circle cx="32" cy="20" r="9" fill="#f0d8b8" />
      <path d="M18 34 L32 29 L46 34 L52 90 H12 Z" fill={coat} />
      <path d="M24 34 L32 44 L40 34" fill={collar} />
      <rect x="26" y="50" width="12" height="6" fill={accent} />
    </svg>
  );
}

export function TeamChips({ filled, total = 6 }: { filled: number; total?: number }) {
  return (
    <div className="team-chips" aria-hidden>
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className={index < filled ? 'team-chip' : 'team-chip empty'} />
      ))}
    </div>
  );
}

function EventSeal() {
  return (
    <span className="event-seal" aria-hidden>♛</span>
  );
}

function eventWatermark(status: string): string {
  if (status === 'completed') return 'CROWN';
  if (status === 'in-progress' || status === 'active' || status === 'ready') return 'LIVE';
  return 'OPEN';
}

export function ResultCard({
  title,
  winner,
  payoutAmount,
  reason,
  href,
  rail,
}: {
  title: string;
  winner?: string;
  payoutAmount?: number;
  reason?: string;
  href?: string;
  rail?: 'legacy_poke' | 'sol_chain';
}) {
  return (
    <Panel eyebrow="Match result" title={title} strong>
      <div className="stack">
        <div className="result-winner">
          <span className="result-crown">WIN</span>
          <div>
            <span className="micro-label">Winner</span>
            <strong>{winner ?? 'Tie / unresolved'}</strong>
          </div>
        </div>
        <div className="economy-row">
          <span className="muted">Match payout</span>
          <Badge tone="live">{payoutAmount !== undefined ? formatRoomAmount(payoutAmount, rail) : '—'}</Badge>
        </div>
        {reason ? <div className="muted">{reason}</div> : null}
        {href ? <Link className="btn btn-primary" href={href}>Open details</Link> : null}
      </div>
    </Panel>
  );
}

export function CasualRoomCard({ room }: { room: CasualRoom }) {
  const waiting = !room.opponentId;
  return (
    <article className={`matchup-row matchup-${room.status}`}>
      <div className="matchup-rail">
        <span className="broadcast-label">{formatLabel(room.format, room.battleSize, room.ruleset)}</span>
        <Badge tone={statusTone(room.status)}>{room.status}</Badge>
      </div>
      <div className="matchup-axis">
        <div className="matchup-trainer matchup-trainer-inline">
          <TrainerFigure />
          <span>
            <small>Trainer</small>
            <strong><TrainerName playerId={room.creatorId} /></strong>
            <TeamChips filled={3} total={3} />
          </span>
        </div>
        <span className="matchup-vs" aria-hidden>VS</span>
        <div className="matchup-trainer matchup-trainer-inline matchup-trainer-foe">
          <span>
            <small>{waiting ? 'Open slot' : 'Opponent'}</small>
            <strong>{room.opponentId ? <TrainerName playerId={room.opponentId} /> : 'Waiting…'}</strong>
            <TeamChips filled={waiting ? 0 : 3} total={3} />
          </span>
          <TrainerFigure foe />
        </div>
      </div>
      <div className="matchup-footer">
        <div className="matchup-stake">
          <strong>{formatRoomAmount(room.collateral, room.rail)}</strong>
          <span>{room.rail === 'sol_chain' ? 'Real SOL' : 'Mock POKE'} each · winner {formatRoomAmount(room.economics.winnerPayout, room.rail)}</span>
        </div>
        <Link className="btn btn-primary" href={`/casual/${room.id}`}>
          {room.status === 'open' ? 'Join' : 'View'}
        </Link>
      </div>
    </article>
  );
}

export function FeaturedMatchup({ room }: { room: CasualRoom }) {
  const waiting = !room.opponentId;
  return (
    <article className={`matchup-stage matchup-${room.status}`}>
      <div className="matchup-rail">
        <span className="broadcast-label">{formatLabel(room.format, room.battleSize, room.ruleset)}</span>
        <span className="live-status"><span />{room.status === 'open' ? 'Open queue' : room.status}</span>
      </div>
      <div className="matchup-axis featured-axis">
        <div className="trainer-card">
          <TrainerFigure size="lg" />
          <div className="trainer-card-copy">
            <small>Trainer card</small>
            <strong><TrainerName playerId={room.creatorId} /></strong>
            <TeamChips filled={5} total={6} />
          </div>
        </div>
        <span className="vs-ring" aria-hidden><span>VS</span></span>
        <div className="trainer-card trainer-card-foe">
          <TrainerFigure foe size="lg" />
          <div className="trainer-card-copy">
            <small>{waiting ? 'Challenger' : 'Opponent'}</small>
            <strong>{room.opponentId ? <TrainerName playerId={room.opponentId} /> : 'Open slot'}</strong>
            <TeamChips filled={waiting ? 0 : 5} total={6} />
          </div>
        </div>
      </div>
      <div className="matchup-footer">
        <div className="matchup-stake">
          <small>Stake each</small>
          <strong>{formatRoomAmount(room.collateral, room.rail)}</strong>
        </div>
        <Link className="btn btn-primary" href={`/casual/${room.id}`}>
          {room.status === 'open' ? 'Join matchup' : 'View matchup'}
        </Link>
      </div>
    </article>
  );
}

export function TournamentCard({ tournament }: { tournament: TournamentSummary }) {
  const field = eventFieldLabel(tournament);
  return (
    <article className="tournament-rail">
      <span className="event-pennant" aria-hidden />
      <EventSeal />
      <div className="tournament-rail-id">
        <span className="broadcast-label">{formatLabel(tournament.format)}</span>
        <strong>{tournament.title}</strong>
        {tournament.winner ? <p className="event-banner-champion">Champion <TrainerName playerId={tournament.winner} /></p> : null}
      </div>
      <dl className="tournament-rail-stats">
        <div>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
        <div>
          <dt>Treasury prize</dt>
          <dd>{formatPoke(tournament.economics.prizePool)}</dd>
        </div>
        <div>
          <dt>Entry</dt>
          <dd>{formatPoke(tournament.entryFee)}</dd>
        </div>
      </dl>
      <Badge tone={statusTone(tournament.status)}>{eventStatusLabel(tournament)}</Badge>
      <Link className="text-link" href={`/tournament/${tournament.id}`}>Watch bracket →</Link>
    </article>
  );
}

export function MatchPreview({ room }: { room: CasualRoom }) {
  const waiting = !room.opponentId;
  return (
    <article className={`match-object match-${room.status}`}>
      <div className="match-object-rail">
        <span className="broadcast-label">{formatLabel(room.format, room.battleSize, room.ruleset)}</span>
        <Badge tone={statusTone(room.status)}>{room.status}</Badge>
      </div>
      <div className="match-object-axis">
        <div className="match-object-trainer">
          <TrainerFigure />
          <span>
            <strong><TrainerName playerId={room.creatorId} /></strong>
            <TeamChips filled={3} total={3} />
          </span>
        </div>
        <span className="match-object-vs" aria-hidden>VS</span>
        <div className="match-object-trainer match-object-foe">
          <span>
            <strong>{room.opponentId ? <TrainerName playerId={room.opponentId} /> : 'Open slot'}</strong>
            <TeamChips filled={waiting ? 0 : 3} total={3} />
          </span>
          <TrainerFigure foe />
        </div>
      </div>
      <div className="match-object-footer">
        <strong>{formatRoomAmount(room.collateral, room.rail)}</strong>
        <Link className="btn btn-primary" href={`/casual/${room.id}`}>
          {room.status === 'open' ? 'Join' : 'View'}
        </Link>
      </div>
    </article>
  );
}

export function TournamentEvent({
  tournament,
  featured = false,
}: {
  tournament: TournamentSummary;
  featured?: boolean;
}) {
  const field = eventFieldLabel(tournament);
  const settled = isSettledEvent(tournament.status);
  const canJoin = tournament.status === 'registration';
  return (
    <article className={`event-banner${featured ? ' event-banner-featured' : ''}`}>
      {featured ? <span className="event-watermark" aria-hidden>{eventWatermark(tournament.status)}</span> : null}
      <span className="event-pennant" aria-hidden />
      <EventSeal />
      <div className="event-banner-body">
        <div className="event-banner-id">
          <span className="broadcast-label">{formatLabel(tournament.format)} · Championship event</span>
          {featured ? <h2>{tournament.title}</h2> : <h3>{tournament.title}</h3>}
          {tournament.winner ? (
            <p className="event-banner-champion">Champion {tournament.winner}</p>
          ) : null}
        </div>
        <dl className="event-banner-meta">
          <div>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
          <div>
            <dt>Treasury prize</dt>
            <dd>{formatPoke(tournament.economics.prizePool)}</dd>
          </div>
          <div>
            <dt>{settled ? 'Entry was' : 'Entry fee'}</dt>
            <dd>{formatPoke(tournament.entryFee)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{eventStatusLabel(tournament)}</dd>
          </div>
        </dl>
      </div>
      <div className="event-banner-actions">
        <Link className={featured ? 'btn btn-primary' : 'text-link'} href={`/tournament/${tournament.id}`}>
          {settled ? 'View bracket' : 'Watch bracket'}
        </Link>
        {canJoin ? <Link className="btn" href={`/tournament/${tournament.id}`}>Join</Link> : null}
        {tournament.status === 'completed' ? (
          <Link className="text-link" href={`/result/${tournament.id}`}>View result →</Link>
        ) : null}
      </div>
    </article>
  );
}

export function EconomyBreakdown({ economics }: { economics: CasualEconomicsPreview | null }) {
  return (
    <div className="economy-breakdown">
      <div className="economy-row">
        <span>Collateral each</span>
        <strong>{economics ? formatPoke(economics.collateral) : '—'}</strong>
      </div>
      <div className="economy-row">
        <span>Gross match pool</span>
        <strong>{economics ? formatPoke(economics.totalPot) : '—'}</strong>
      </div>
      <div className="economy-row economy-fee">
        <span>Protocol fee · 2% at match start</span>
        <strong>{economics ? formatPoke(economics.protocolFee) : '—'}</strong>
      </div>
      <div className="economy-row economy-total">
        <span>Winner receives</span>
        <strong>{economics ? formatPoke(economics.winnerPayout) : '—'}</strong>
      </div>
      <p className="economy-note">One fee from the gross pool. No withdrawal tax.</p>
    </div>
  );
}

export function CompetitivePaths() {
  return (
    <div className="pa-paths">
      <article className="pa-path casual">
        <small>Casual</small>
        <strong>Wager SOL</strong>
        <p>Ready up, wait for the countdown, then pick three from a random curated six — or bring your own Gen 9 OU team. Each side posts SOL collateral; one 2% fee comes off the gross pool at match start.</p>
        <Link className="pa-btn pa-btn-primary pa-btn-sm" href="/arena">Find a fight</Link>
      </article>
      <article className="pa-path cup">
        <small>Tournament</small>
        <strong>Low entry. Treasury prizes.</strong>
        <p>Compete for prizes funded by the Tournament Treasury, not by large player collateral.</p>
        <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/tournaments">Browse cups</Link>
      </article>
    </div>
  );
}

export function TournamentEconomicsBlock({
  economics,
  entryFee,
  compact = false,
}: {
  economics?: TournamentEconomicsPreview | null;
  entryFee?: number;
  compact?: boolean;
}) {
  const entry = entryFee ?? economics?.entryFee;
  return (
    <div className={`pa-cup-econ${compact ? ' compact' : ''}`}>
      <div><span>Entry fee</span><strong>{entry !== undefined ? formatPoke(entry) : '—'}</strong></div>
      <div><span>Treasury-funded prize</span><strong>{economics ? formatPoke(economics.prizePool) : '—'}</strong></div>
      {!compact ? (
        <>
          <div><span>Field size</span><strong>{economics ? `${economics.playerCount} trainers` : '—'}</strong></div>
          <div><span>Prize distribution</span><strong>Champion payout</strong></div>
          <p className="economy-note">
            Intended funding: Tournament Treasury from creator/dev rewards. Displayed prize is a mock estimate — not an immediately withdrawable balance.
          </p>
        </>
      ) : (
        <p className="economy-note">Low entry. Treasury-funded prize. Mock estimate.</p>
      )}
    </div>
  );
}

export function CasualPoolEquation({ economics }: { economics: CasualEconomicsPreview | null }) {
  if (!economics) {
    return <p className="muted">Enter collateral to preview the player-funded pool.</p>;
  }
  return (
    <div className="pa-pool-eq">
      <div className="pa-pool-eq-row">
        <span>{formatPoke(economics.collateral)}</span>
        <small>collateral</small>
        <i>+</i>
        <span>{formatPoke(economics.collateral)}</span>
        <small>collateral</small>
        <i>=</i>
        <strong>{formatPoke(economics.totalPot)}</strong>
        <small>gross pool</small>
      </div>
      <div className="pa-pool-eq-row fee">
        <span>2% protocol fee at match start</span>
        <strong>{formatPoke(economics.protocolFee)}</strong>
      </div>
      <div className="pa-pool-eq-row payout">
        <span>Winner payout</span>
        <strong>{formatPoke(economics.winnerPayout)}</strong>
      </div>
      <p className="economy-note">Player-funded. One fee from the gross pool. No withdrawal tax.</p>
    </div>
  );
}

export function FlowSteps() {
  return (
    <ol className="flow-strip">
      {['Challenge', 'Stake', 'Battle', 'Win', 'Tournament'].map((step, index) => (
        <li key={step}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <strong>{step}</strong>
        </li>
      ))}
    </ol>
  );
}

export function TrainerVersus({
  left,
  right,
  leftReady,
  rightReady,
}: {
  left: string;
  right?: string;
  leftReady?: boolean;
  rightReady?: boolean;
}) {
  return (
    <div className="versus-lockup">
      <div className="trainer-tile">
        <TrainerFigure size="lg" />
        <small>Your trainer</small>
        <strong>{left}</strong>
        <TeamChips filled={5} total={6} />
        <Badge tone={leftReady ? 'success' : 'default'}>{leftReady ? 'Ready' : 'Preparing'}</Badge>
      </div>
      <span className="versus-mark" aria-hidden>VS</span>
      <div className="trainer-tile">
        <TrainerFigure foe size="lg" />
        <small>Opponent</small>
        <strong>{right ?? 'Waiting…'}</strong>
        <TeamChips filled={right ? 5 : 0} total={6} />
        <Badge tone={rightReady ? 'success' : 'default'}>{right ? (rightReady ? 'Ready' : 'Joined') : 'Open queue'}</Badge>
      </div>
    </div>
  );
}

