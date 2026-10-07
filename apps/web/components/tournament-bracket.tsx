'use client';

import Link from 'next/link';
import { useEffect, useRef, type ReactNode } from 'react';

import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import type { BracketMatch } from '@/lib/tournament-hub';
import { roundLabel } from '@/lib/tournament-schedule';
import {
  canOpenMatch,
  currentRound,
  eliminatedIn,
  findPlayerMatch,
  groupedRounds,
  totalRounds,
  isLiveMatch,
  isSettledMatch,
  matchActionLabel,
  matchDurationMs,
  matchStatusLabel,
  matchTone,
  playerScore,
  progressionSteps,
  formatClock,
} from '@/lib/tournament-hub';

function MatchPlayerRow({
  playerId,
  match,
  viewerId,
  compact = false,
}: {
  playerId?: string;
  match: BracketMatch;
  viewerId?: string | null;
  compact?: boolean;
}) {
  const won = Boolean(match.winner && playerId && match.winner === playerId);
  const lost = Boolean(match.winner && playerId && match.winner !== playerId);
  const mine = Boolean(viewerId && playerId && viewerId === playerId);
  const score = playerScore(match, playerId);
  return (
    <div className={`pa-tree-row${won ? ' is-won' : ''}${lost ? ' is-lost' : ''}${mine ? ' is-mine' : ''}${playerId ? '' : ' is-empty'}${compact ? ' is-compact' : ''}`}>
      {playerId && !compact ? (
        <ProfileTrainerSprite label={playerId} side="left" />
      ) : (
        <span className="pa-tree-avatar" aria-hidden />
      )}
      <span className="pa-tree-name">
        {playerId ? <TrainerName playerId={playerId} /> : 'TBD'}
      </span>
      {score == null ? <span className="pa-tree-score" /> : <span className="pa-tree-score">{score}</span>}
    </div>
  );
}

function MatchCard({
  match,
  viewerId,
  selected,
  onSelect,
  layout,
  phase,
  youHere,
}: {
  match: BracketMatch;
  viewerId?: string | null;
  selected: boolean;
  onSelect: (match: BracketMatch) => void;
  layout: 'opening' | 'mid' | 'semi' | 'final';
  phase: 'done' | 'current' | 'future';
  youHere: boolean;
}) {
  const tone = matchTone(match.status);
  const live = isLiveMatch(match.status);
  const mine = Boolean(viewerId && (match.player1 === viewerId || match.player2 === viewerId));
  const openable = canOpenMatch(match);
  const vacant = !match.player1 && !match.player2;
  return (
    <article
      className={`pa-tree-match is-${tone} is-${layout} is-round-${phase}${mine ? ' is-path' : ''}${youHere ? ' is-you' : ''}${selected ? ' is-selected' : ''}${live ? ' is-live' : ''}${vacant ? ' is-vacant' : ''}`}
      data-match={match.id}
    >
      <button
        type="button"
        className="pa-tree-match-btn"
        disabled={!openable}
        onClick={() => onSelect(match)}
        aria-pressed={selected}
      >
        {youHere ? <span className="pa-tree-you">You</span> : null}
        {tone === 'future' || match.placeholder ? null : (
          <span className="pa-tree-match-status">{matchStatusLabel(match.status)}</span>
        )}
        <MatchPlayerRow playerId={match.player1} match={match} viewerId={viewerId} compact={layout === 'opening'} />
        <MatchPlayerRow playerId={match.player2} match={match} viewerId={viewerId} compact={layout === 'opening'} />
      </button>
    </article>
  );
}

type RoundPhase = 'done' | 'current' | 'future';
type StageMode = 'pods' | 'quarters' | 'semis' | 'championship';

const POD_LETTERS = 'ABCDEFGH';

function shortRound(label: string): string {
  if (label === 'ROUND OF 32') return 'R32';
  if (label === 'ROUND OF 16') return 'R16';
  if (label === 'QUARTERFINALS') return 'QF';
  if (label === 'SEMIFINALS') return 'SF';
  if (label === 'FINAL') return 'Final';
  return label;
}

function matchAt(matches: BracketMatch[], round: number, position: number): BracketMatch {
  return matches.find(match => match.round === round && match.bracketPosition === position) ?? {
    id: `gap-r${round}-p${position}`,
    round,
    bracketPosition: position,
    status: 'pending',
    placeholder: true,
  };
}

function slotPositions(podIndex: number, podRound: number, round: number): number[] {
  const span = 2 ** (podRound - round);
  const start = podIndex * span;
  return Array.from({ length: span }, (_, index) => start + index);
}

function roundWithCount(maxPlayers: number, count: number): number | null {
  let matchesInRound = maxPlayers / 2;
  let round = 1;
  while (matchesInRound >= 1) {
    if (matchesInRound === count) return round;
    matchesInRound /= 2;
    round += 1;
  }
  return null;
}

function NameSlot({ id, winner }: { id?: string; winner?: string }) {
  if (!id) return <span className="is-tbd">TBD</span>;
  const tone = winner ? (winner === id ? 'is-won' : 'is-lost') : '';
  return <span className={tone}><TrainerName playerId={id} /></span>;
}

function PathRow({
  match,
  label,
  viewerId,
  selected,
  onSelect,
}: {
  match: BracketMatch;
  label: string;
  viewerId?: string | null;
  selected: boolean;
  onSelect: (match: BracketMatch) => void;
}) {
  const openable = canOpenMatch(match);
  const mine = Boolean(viewerId && (match.player1 === viewerId || match.player2 === viewerId));
  const vacant = !match.player1 && !match.player2;
  return (
    <button
      type="button"
      className={`pa-path-row${mine ? ' is-mine' : ''}${vacant ? ' is-vacant' : ''}${selected ? ' is-selected' : ''}`}
      disabled={!openable}
      onClick={() => onSelect(match)}
    >
      <i>{label}</i>
      <NameSlot id={match.player1} winner={match.winner} />
      <em>vs</em>
      <NameSlot id={match.player2} winner={match.winner} />
    </button>
  );
}

function StageMap({
  maxPlayers,
  active,
  status,
}: {
  maxPlayers: number;
  active: number;
  status?: string;
}) {
  const steps = progressionSteps(maxPlayers, active, status);
  return (
    <ol className="pa-stage-map" aria-label="Tournament progression">
      {steps.map(step => (
        <li key={step.round} className={`is-${step.state === 'upcoming' ? 'future' : step.state}`}>
          <i aria-hidden />
          <span>{shortRound(step.label)}</span>
        </li>
      ))}
    </ol>
  );
}

function ChampionLine({ winner }: { winner?: string }) {
  return (
    <div className={`pa-tree-champion${winner ? ' is-crowned' : ' is-empty'}`}>
      <span>Champion</span>
      <strong>{winner ? <TrainerName playerId={winner} /> : 'TBD'}</strong>
    </div>
  );
}

function CrownBar({ match, winner }: { match: BracketMatch; winner?: string }) {
  const set = Boolean(match.player1 || match.player2);
  return (
    <div className={`pa-stage-crown${winner ? ' is-crowned' : ''}${set ? ' is-set' : ''}`}>
      <div>
        <span>Final</span>
        <strong>
          <NameSlot id={match.player1} winner={match.winner} />
          <em>vs</em>
          <NameSlot id={match.player2} winner={match.winner} />
        </strong>
      </div>
      <div>
        <span>Champion</span>
        <strong>{winner ? <TrainerName playerId={winner} /> : 'TBD'}</strong>
      </div>
    </div>
  );
}

function HeroFinal({
  match,
  winner,
  viewerId,
  selectedId,
  onSelect,
  phase,
  youHere,
}: {
  match: BracketMatch;
  winner?: string;
  viewerId?: string | null;
  selectedId?: string | null;
  onSelect: (match: BracketMatch) => void;
  phase: RoundPhase;
  youHere: boolean;
}) {
  const vacant = !match.player1 && !match.player2;
  return (
    <div className={`pa-stage-hero${winner ? ' is-crowned' : ''}${vacant ? ' is-waiting' : ''}`}>
      <span className="pa-stage-kicker">Championship</span>
      <MatchCard
        match={match}
        viewerId={viewerId}
        selected={selectedId === match.id}
        onSelect={onSelect}
        layout="final"
        phase={phase}
        youHere={youHere}
      />
      <ChampionLine winner={winner} />
    </div>
  );
}

function PodBlock({
  pod,
  cardLayout,
  renderCard,
  renderPath,
}: {
  pod: {
    letter: string;
    yours: boolean;
    past: BracketMatch[];
    current: BracketMatch[];
    ahead: BracketMatch[];
  };
  cardLayout: 'opening' | 'mid' | 'semi';
  renderCard: (match: BracketMatch, layout: 'opening' | 'mid' | 'semi' | 'final', phase: RoundPhase) => ReactNode;
  renderPath: (match: BracketMatch) => ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pod.yours) return;
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pod.yours]);
  return (
    <article ref={ref} className={`pa-pod${pod.yours ? ' is-yours' : ''}`}>
      <header className="pa-pod-head">
        <span>Pod {pod.letter}</span>
        {pod.yours ? <em>You</em> : <em>{pod.current.length} matches</em>}
      </header>
      {pod.past.length ? <div className="pa-pod-past">{pod.past.map(renderPath)}</div> : null}
      <div className="pa-pod-matches">
        {pod.current.map(match => renderCard(match, cardLayout, 'current'))}
      </div>
      {pod.ahead.length ? <div className="pa-pod-ahead">{pod.ahead.map(renderPath)}</div> : null}
    </article>
  );
}

function Championship({
  matches,
  lastRound,
  finalMatch,
  winner,
  viewerId,
  selectedId,
  onSelect,
  phase,
  renderPath,
}: {
  matches: BracketMatch[];
  lastRound: number;
  finalMatch: BracketMatch;
  winner?: string;
  viewerId?: string | null;
  selectedId?: string | null;
  onSelect: (match: BracketMatch) => void;
  phase: RoundPhase;
  renderPath: (match: BracketMatch) => ReactNode;
}) {
  const semiRound = lastRound - 1;
  return (
    <div className="pa-stage-late">
      <header className="pa-stage-now">
        <h3>{winner && phase === 'done' ? 'Champion' : 'Final'}</h3>
      </header>
      {semiRound >= 1 ? (
        <div className="pa-stage-semis is-results">
          {[0, 1].map(position => {
            const match = matchAt(matches, semiRound, position);
            return match.id.startsWith('gap-') ? null : renderPath(match);
          })}
        </div>
      ) : null}
      {(() => {
        const placement = matches.find(match => (
          match.role === 'third-place' || (match.round === lastRound && match.bracketPosition === 1)
        ));
        if (!placement || placement.id.startsWith('gap-')) return null;
        return (
          <PathRow
            match={placement}
            label="3rd"
            viewerId={viewerId}
            selected={selectedId === placement.id}
            onSelect={onSelect}
          />
        );
      })()}
      <HeroFinal
        match={finalMatch}
        winner={winner}
        viewerId={viewerId}
        selectedId={selectedId}
        onSelect={onSelect}
        phase={phase}
        youHere={Boolean(viewerId && (finalMatch.player1 === viewerId || finalMatch.player2 === viewerId))}
      />
    </div>
  );
}

export function TournamentBracket({
  matches,
  maxPlayers,
  viewerId,
  winner,
  status,
  selectedId,
  onSelect,
}: {
  matches: BracketMatch[];
  maxPlayers: number;
  viewerId?: string | null;
  winner?: string;
  status?: string;
  selectedId?: string | null;
  onSelect: (match: BracketMatch) => void;
}) {
  const rounds = groupedRounds(matches, maxPlayers);
  const lastRound = totalRounds(maxPlayers);
  const activeRound = currentRound(matches, status);
  const completed = status === 'completed';
  const activeMatches = rounds.find(group => group.round === activeRound)?.matches ?? [];
  const expectedInActive = Math.max(1, maxPlayers / (2 ** activeRound));
  const mode: StageMode = completed || activeRound >= lastRound
    ? 'championship'
    : expectedInActive <= 2
      ? 'semis'
      : expectedInActive <= 4
        ? 'quarters'
        : 'pods';
  const podRound = roundWithCount(maxPlayers, 4);
  const real = matches.filter(match => !match.placeholder);
  const youMatch = findPlayerMatch(real, viewerId);
  const lost = viewerId ? eliminatedIn(real, viewerId) : undefined;
  const focus = lost ?? youMatch;
  const finalMatch = matchAt(matches, lastRound, 0);
  const labelFor = (round: number) => shortRound(rounds.find(group => group.round === round)?.label ?? roundLabel(round, maxPlayers));
  const phaseFor = (round: number): RoundPhase => {
    if (completed) return 'done';
    if (round < activeRound) return 'done';
    if (round === activeRound) return 'current';
    return 'future';
  };
  const cardLayout = expectedInActive > 8 ? 'opening' as const : expectedInActive > 4 ? 'mid' as const : 'semi' as const;
  const preview = activeMatches.every(match => match.placeholder || (!match.player1 && !match.player2));
  const podLetter = (match: BracketMatch) => {
    if (!podRound || match.round > podRound) return null;
    const index = Math.floor(match.bracketPosition / (2 ** (podRound - match.round)));
    return POD_LETTERS[index] ?? null;
  };

  const focusId = focus?.id;
  const roundsLeft = focus ? lastRound - focus.round : null;
  const letter = focus ? podLetter(focus) : null;
  const activeLabel = rounds.find(group => group.round === activeRound)?.label ?? roundLabel(activeRound, maxPlayers);

  const renderCard = (match: BracketMatch, layout: 'opening' | 'mid' | 'semi' | 'final', phase: RoundPhase) => (
    <MatchCard
      key={match.id}
      match={match}
      viewerId={viewerId}
      selected={selectedId === match.id}
      onSelect={onSelect}
      layout={layout}
      phase={phase}
      youHere={match.id === focusId}
    />
  );

  const renderPath = (match: BracketMatch) => (
    <PathRow
      key={match.id}
      match={match}
      label={labelFor(match.round)}
      viewerId={viewerId}
      selected={selectedId === match.id}
      onSelect={onSelect}
    />
  );

  const pods = mode === 'pods' && podRound != null && podRound >= activeRound
    ? Array.from({ length: 4 }, (_, index) => {
      const collect = (round: number) => slotPositions(index, podRound, round).map(position => matchAt(matches, round, position));
      const past: BracketMatch[] = [];
      for (let round = 1; round < activeRound; round += 1) past.push(...collect(round));
      const ahead: BracketMatch[] = [];
      for (let round = activeRound + 1; round <= podRound; round += 1) ahead.push(...collect(round));
      const current = collect(activeRound);
      const yours = Boolean(focus && [...past, ...current, ...ahead].some(match => match.id === focus.id));
      return { index, letter: POD_LETTERS[index] ?? String(index + 1), past, current, ahead, yours };
    })
    : [];

  return (
    <div className="pa-stage">
      <StageMap maxPlayers={maxPlayers} active={activeRound} status={status} />
      {focus ? (
        <p className={`pa-stage-locate${lost ? ' is-out' : ''}`}>
          <b>{lost ? 'Out' : 'You'}</b>
          {letter ? <strong>Pod {letter}</strong> : null}
          <span>{lost ? roundLabel(lost.round, maxPlayers) : activeLabel}</span>
          {roundsLeft != null && roundsLeft > 0 && !lost ? (
            <em>{roundsLeft === 1 ? '1 round to the final' : `${roundsLeft} rounds to the final`}</em>
          ) : null}
        </p>
      ) : preview ? (
        <p className="pa-stage-note">Matches fill in when the field locks.</p>
      ) : null}

      {mode === 'championship' ? (
        <Championship
          matches={matches}
          lastRound={lastRound}
          finalMatch={finalMatch}
          winner={winner}
          viewerId={viewerId}
          selectedId={selectedId}
          onSelect={onSelect}
          phase={phaseFor(lastRound)}
          renderPath={renderPath}
        />
      ) : mode === 'semis' ? (
        <div className="pa-stage-late">
          <header className="pa-stage-now">
            <h3>{activeLabel}</h3>
            <span>{expectedInActive} matches</span>
          </header>
          <div className="pa-stage-semis">
            {activeMatches.map(match => renderCard(match, 'semi', 'current'))}
          </div>
          <HeroFinal
            match={finalMatch}
            winner={winner}
            viewerId={viewerId}
            selectedId={selectedId}
            onSelect={onSelect}
            phase={!finalMatch.player1 && !finalMatch.player2 ? 'future' : 'current'}
            youHere={finalMatch.id === focusId}
          />
        </div>
      ) : mode === 'quarters' ? (
        <div className="pa-stage-late">
          <header className="pa-stage-now">
            <h3>{activeLabel}</h3>
            <span>{expectedInActive} matches</span>
          </header>
          <div className="pa-stage-quarters">
            {[0, 1].map(side => (
              <section key={side} className="pa-stage-pair">
                {activeMatches
                  .filter(match => Math.floor(match.bracketPosition / 2) === side)
                  .map(match => renderCard(match, 'mid', 'current'))}
                {(() => {
                  const next = matchAt(matches, activeRound + 1, side);
                  return next.id.startsWith('gap-') ? null : renderPath(next);
                })()}
              </section>
            ))}
          </div>
          {activeRound + 1 < lastRound ? (
            <CrownBar match={finalMatch} winner={winner} />
          ) : null}
        </div>
      ) : (
        <div className="pa-stage-early">
          <header className="pa-stage-now">
            <h3>{activeLabel}</h3>
            <span>{expectedInActive} matches</span>
          </header>
          {[0, 1].map(side => (
            <section key={side} className="pa-stage-lane">
              <div className="pa-stage-pods">
                {pods.filter(pod => Math.floor(pod.index / 2) === side).map(pod => (
                  <PodBlock
                    key={pod.letter}
                    pod={pod}
                    cardLayout={cardLayout}
                    renderCard={renderCard}
                    renderPath={renderPath}
                  />
                ))}
              </div>
              {podRound != null && podRound < lastRound - 1 ? (
                <div className="pa-lane-next">
                  {renderPath(matchAt(matches, podRound + 1, side))}
                </div>
              ) : null}
            </section>
          ))}
          <CrownBar match={finalMatch} winner={winner} />
        </div>
      )}
    </div>
  );
}

export function MatchDetailDialog({
  match,
  viewerId,
  onClose,
}: {
  match: BracketMatch | null;
  viewerId?: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!match) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [match, onClose]);

  if (!match) return null;
  const action = matchActionLabel(match, viewerId);
  const duration = matchDurationMs(match);
  const mine = Boolean(viewerId && (match.player1 === viewerId || match.player2 === viewerId));
  const settled = isSettledMatch(match.status);
  const forfeit = match.status === 'forfeited' || match.result?.kind === 'forfeit' || match.result?.battleResult?.endedBy === 'timeout';

  return (
    <div className="pa-match-overlay" onClick={onClose}>
      <aside
        className="pa-match-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Match details"
        onClick={event => event.stopPropagation()}
      >
        <header>
          <span className={`pa-tree-match-status is-${matchTone(match.status)}`}>
            {matchStatusLabel(match.status)}
          </span>
          <button type="button" className="pa-match-close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        <div className="pa-match-dialog-fighters">
          <MatchPlayerRow playerId={match.player1} match={match} viewerId={viewerId} />
          <MatchPlayerRow playerId={match.player2} match={match} viewerId={viewerId} />
        </div>
        <dl className="pa-cup-facts">
          {settled ? (
            <div>
              <dt>Winner</dt>
              <dd>{match.winner ? <TrainerName playerId={match.winner} /> : match.status === 'tied' ? 'Tie' : '—'}</dd>
            </div>
          ) : null}
          <div>
            <dt>Status</dt>
            <dd>{matchStatusLabel(match.status)}</dd>
          </div>
          {duration != null ? (
            <div>
              <dt>Duration</dt>
              <dd>{formatClock(duration)}</dd>
            </div>
          ) : null}
          {match.result?.battleResult?.turns ? (
            <div>
              <dt>Turns</dt>
              <dd>{match.result.battleResult.turns}</dd>
            </div>
          ) : null}
          {forfeit ? (
            <div>
              <dt>Outcome</dt>
              <dd>{match.result?.battleResult?.endedBy === 'timeout' ? 'Timeout forfeit' : 'Forfeit'}</dd>
            </div>
          ) : null}
        </dl>
        {action ? (
          <Link className="pa-btn pa-btn-primary" href={`/battle/${match.id}`}>
            {mine && isLiveMatch(match.status) ? 'Enter battle' : action}
          </Link>
        ) : (
          <p className="pa-cup-note">This match is still waiting for both trainers.</p>
        )}
      </aside>
    </div>
  );
}
