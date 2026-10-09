'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { CupIcon, type CupIconName } from '@/components/cup-icons';
import { CupMeter } from '@/components/cup-meter';
import { ErrorToast } from '@/components/error-toast';
import { FormatStage, Gen1CupArt } from '@/components/gen1-cup-art';
import { useArena } from '@/lib/arena-context';
import { formatPoke, formatPokeFromAtoms, formatTournamentEntry, formatTournamentPrize, TOURNAMENT_BURN_FEE_ATOMS } from '@/lib/api-client';
import { isLocalTestMode } from '@/lib/local-test-mode';
import {
  TOURNAMENT_ENTRY_POKE,
  buildTournamentSchedule,
  displayedFieldSize,
  formatCountdown,
  roundLabel,
  scheduleCountdown,
  scheduleCtaLabel,
  scheduleStatusLabel,
  type ScheduleSlot,
} from '@/lib/tournament-schedule';
import { readSavedTeam } from '@/lib/team';

const ROTATION_PREVIEW = 6;

type Scheduler = { enabled: boolean; nextTournamentStartAt?: number; nextRotationIndex: number } | undefined;

export default function TournamentsPage() {
  const { client, snapshot, refreshSnapshot, connected, walletConnected, connectInjectedWallet, connectingWallet, playerId, chainEconomyEnabled } = useArena();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // null until mount so SSR and hydration share the same countdown placeholder
  const [now, setNow] = useState<number | null>(null);
  const localTestMode = isLocalTestMode();

  useEffect(() => {
    if (!connected) return;
    void client.request({ type: 'tournament.list' }).then(() => refreshSnapshot()).catch(() => undefined);
  }, [client, connected, refreshSnapshot]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const chain = chainEconomyEnabled;
  const scheduler = snapshot?.tournamentScheduler;
  const schedule = useMemo(
    () => buildTournamentSchedule(snapshot?.tournaments ?? [], now ?? Date.now(), {
      allAvailable: localTestMode,
      scheduler,
    }),
    [localTestMode, scheduler?.enabled, scheduler?.nextRotationIndex, scheduler?.nextTournamentStartAt, snapshot?.tournaments, now],
  );

  const ensureTournament = async (slot: ScheduleSlot): Promise<string | null> => {
    if (slot.tournament) return slot.tournament.id;
    if (scheduler?.enabled !== true) {
      setError('Tournament scheduling is off. This slot is not open.');
      return null;
    }
    if (!walletConnected) {
      setError('Connect a wallet before joining a tournament.');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await client.request({
        type: 'tournament.create',
        title: slot.title,
        maxPlayers: slot.maxPlayers,
        entryFee: TOURNAMENT_ENTRY_POKE,
        ruleset: slot.rulesetId,
      });
      await refreshSnapshot();
      if (response.type === 'tournament.created') {
        return (response.tournament as { id?: string })?.id ?? null;
      }
      return null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const teamReadyFor = (slot: ScheduleSlot) => (
    slot.format.teamMode === 'custom'
      ? Boolean(playerId && readSavedTeam(playerId, slot.rulesetId)?.validated
        && readSavedTeam(playerId, slot.rulesetId)?.paste.trim())
      : null
  );

  const joinSlot = async (slot: ScheduleSlot) => {
    if (slot.when !== 'CURRENT') return;
    if (slot.format.teamMode === 'custom') {
      const saved = playerId ? readSavedTeam(playerId, slot.rulesetId) : null;
      if (!saved?.validated || !saved.paste.trim()) {
        window.location.href = `/teams/builder?ruleset=${slot.rulesetId}`;
        return;
      }
      const id = slot.tournament?.id ?? await ensureTournament(slot);
      if (!id) return;
      try {
        await client.request({
          type: 'tournament.join',
          tournamentId: id,
          team: saved.paste,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (!/already registered/i.test(text)) {
          setError(text);
          return;
        }
      }
      window.location.href = `/tournament/${id}`;
      return;
    }
    if (slot.tournament) {
      window.location.href = `/tournament/${slot.tournament.id}`;
      return;
    }
    const id = await ensureTournament(slot);
    if (id) window.location.href = `/tournament/${id}`;
  };

  const [featured, ...rotation] = schedule;
  const shownRotation = showAll ? rotation : rotation.slice(0, ROTATION_PREVIEW);
  const firstRound = roundLabel(1, schedule[0]?.maxPlayers ?? 32);
  const path: Array<{ icon: CupIconName; label: string; detail: string }> = [
    { icon: 'ticket', label: 'Register', detail: 'Take a seat while the field is open.' },
    { icon: 'lock', label: 'Finalize', detail: 'A full field starts one shared lock timer.' },
    { icon: 'swords', label: firstRound, detail: 'Single elimination. Best of 1.' },
    { icon: 'flag', label: 'Final', detail: 'Semifinal losers play for 3rd.' },
    { icon: 'crown', label: 'Champion', detail: 'The treasury-funded prize settles.' },
  ];

  return (
    <div className="pa-page cup-page">
      <header className="cup-head">
        <div className="cup-head-copy">
          <h1 className="cup-title">Tournament schedule</h1>
          <p className="cup-lead">
            Preset Gen X, then that generation&apos;s custom cup, then Gen 9 OU. Automatic rotation starts only when enabled.
          </p>
        </div>
        <div className="cup-actions">
          {!walletConnected ? (
            <button
              type="button"
              className="pa-btn pa-btn-primary"
              disabled={connectingWallet}
              onClick={() => void connectInjectedWallet()}
            >
              {connectingWallet ? 'Connecting…' : 'Connect wallet'}
            </button>
          ) : null}
          <Link className="pa-btn pa-btn-surface" href="/treasury">Treasury map</Link>
        </div>
      </header>

      <ErrorToast error={error} onDismiss={() => setError(null)} />

      <div className="cup-ticker">
        <span className={scheduler?.enabled ? 'is-on' : 'is-off'}>
          <i className={`cup-dot${scheduler?.enabled ? ' is-pulse' : ''}`} aria-hidden />
          {scheduler?.enabled
            ? scheduler.nextTournamentStartAt
              ? <>Next tournament in <b>{formatCountdown(scheduler.nextTournamentStartAt, now ?? Date.now())}</b></>
              : 'Scheduling enabled'
            : 'Scheduling OFF'}
        </span>
        {scheduler?.enabled && scheduler.nextTournamentStartAt ? (
          <span>
            <CupIcon name="clock" />
            Starts <b>{new Date(scheduler.nextTournamentStartAt).toLocaleString()}</b>
          </span>
        ) : null}
        {!scheduler?.enabled ? <span>No automatic tournament creation</span> : null}
        <span className="cup-ticker-rotation">
          Casual <i>→</i> Cup <i>→</i> Gen 9 OU
        </span>
      </div>

      {featured ? (
        <SlotCard
          variant="feature"
          slot={featured}
          now={now}
          scheduler={scheduler}
          busy={busy}
          chain={chain}
          teamReady={teamReadyFor(featured)}
          onJoin={() => void joinSlot(featured)}
        />
      ) : null}

      {rotation.length ? (
        <section className="cup-section" aria-labelledby="cup-rotation-title">
          <div className="cup-section-head">
            <h2 id="cup-rotation-title">Up next</h2>
            <span>{rotation.length} more in rotation</span>
          </div>
          <div className="cup-rotation">
            {shownRotation.map(slot => (
              <SlotCard
                key={slot.key}
                variant="slot"
                slot={slot}
                now={now}
                scheduler={scheduler}
                busy={busy}
                chain={chain}
                teamReady={teamReadyFor(slot)}
                onJoin={() => void joinSlot(slot)}
              />
            ))}
          </div>
          {rotation.length > ROTATION_PREVIEW ? (
            <button
              type="button"
              className="pa-btn pa-btn-surface cup-more"
              aria-expanded={showAll}
              onClick={() => setShowAll(value => !value)}
            >
              {showAll ? 'Show less' : `Show full rotation · ${rotation.length - ROTATION_PREVIEW} more`}
            </button>
          ) : null}
        </section>
      ) : null}

      <ol className="cup-panel cup-path" aria-label="How a cup runs">
        {path.map(step => (
          <li key={step.label}>
            <i><CupIcon name={step.icon} /></i>
            <b>{step.label}</b>
            <small>{step.detail}</small>
          </li>
        ))}
      </ol>
    </div>
  );
}

function statusTone(status: string): string {
  if (status === 'REGISTERING') return 'is-open';
  if (status === 'FINALIZING') return 'is-warn';
  if (status === 'LIVE') return 'is-live';
  if (status === 'FULL' || status === 'SCHEDULED') return 'is-info';
  return 'is-done';
}

function whenLabel(when: ScheduleSlot['when']): string {
  if (when === 'CURRENT') return 'Current';
  if (when === 'NEXT') return 'Next';
  return 'Later';
}

function SlotCard({
  variant,
  slot,
  now,
  scheduler,
  busy,
  chain,
  teamReady,
  onJoin,
}: {
  variant: 'feature' | 'slot';
  slot: ScheduleSlot;
  now: number | null;
  scheduler: Scheduler;
  busy: boolean;
  chain: boolean;
  teamReady: boolean | null;
  onJoin: () => void;
}) {
  const joinable = slot.when === 'CURRENT' && !slot.isLocked;
  const prizeKnown = joinable && Boolean(slot.tournament);
  const slotOpen = joinable && (Boolean(slot.tournament) || scheduler?.enabled === true);
  const players = slot.tournament?.playerCount ?? 0;
  const maxPlayers = displayedFieldSize(slot);
  const fieldFull = players >= maxPlayers;
  const status = scheduleStatusLabel(slot, scheduler);
  const countdownState = scheduleCountdown(slot, scheduler, now ?? Date.now());
  const countdown = countdownState && now != null
    ? formatCountdown(countdownState.target, now)
    : null;
  const countdownLabel = countdownState?.label;
  const cta = joinable
    ? slotOpen ? scheduleCtaLabel(slot) : 'NOT SCHEDULED'
    : 'UPCOMING';
  const href = joinable && slot.tournament ? `/tournament/${slot.tournament.id}` : undefined;
  const isGen1Cup = slot.format.id === 'gen1cup';
  const isChain = slot.tournament?.rail === 'sol_chain' || (!slot.tournament && chain);
  const prize = prizeKnown
    ? formatTournamentPrize(slot.tournament)
    : 'TBD';
  const entry = slot.tournament
    ? formatTournamentEntry(slot.tournament)
    : (isChain ? formatPokeFromAtoms(TOURNAMENT_BURN_FEE_ATOMS) : formatPoke(TOURNAMENT_ENTRY_POKE));
  const feature = variant === 'feature';

  const action = !joinable && status === 'ROTATION PREVIEW' ? (
    <button type="button" className="pa-btn pa-btn-surface" disabled>
      Scheduling starts soon
    </button>
  ) : !joinable ? (
    <button type="button" className="pa-btn pa-btn-surface" disabled>
      Upcoming
    </button>
  ) : !slotOpen ? (
    <button type="button" className="pa-btn pa-btn-surface" disabled>
      Not scheduled
    </button>
  ) : teamReady === false ? (
    <Link className="pa-btn pa-btn-gold" href={`/teams/builder?ruleset=${slot.rulesetId}`}>
      No available team
    </Link>
  ) : href ? (
    <Link className="pa-btn pa-btn-gold" href={href}>{cta}</Link>
  ) : (
    <button
      type="button"
      className="pa-btn pa-btn-gold"
      disabled={busy}
      onClick={onJoin}
    >
      {busy ? 'Opening…' : cta}
    </button>
  );

  const art = (
    <div className="cup-art" style={{ '--cup-art-bg': `url('${slot.format.backdrop}')` } as CSSProperties}>
      <span className={`cup-pill ${slot.when === 'CURRENT' ? 'is-accent' : 'is-done'} ${feature ? 'cup-feature-when' : 'cup-slot-when'}`}>
        {whenLabel(slot.when)}
      </span>
      {feature ? (
        <span className="cup-art-mark" aria-hidden>
          {slot.format.region}
          <small>{slot.format.restriction}</small>
        </span>
      ) : null}
      {isGen1Cup ? (
        <Gen1CupArt compact={!feature} />
      ) : (
        <FormatStage compact={!feature} trainer={slot.format.trainer} pokemon={slot.format.pokemon} />
      )}
      {countdownState && countdown ? (
        <div className="cup-art-clock" aria-label={`${countdownLabel} ${countdown}`}>
          <small>{countdownLabel}</small>
          <strong>{countdown}</strong>
        </div>
      ) : slot.isLocked ? (
        <div className="cup-art-clock is-lock" role="img" aria-label="Tournament locked">
          <CupIcon name="lock" />
        </div>
      ) : null}
    </div>
  );

  const className = `cup-panel cup-accent-${slot.format.accent}${joinable ? '' : ' is-upcoming'}${slot.isLocked ? ' is-locked' : ''}`;

  if (!feature) {
    return (
      <article className={`${className} cup-slot`}>
        {art}
        <div className="cup-slot-body">
          <span className="cup-feature-theme">{slot.themeLabel}</span>
          <h3>{slot.title}</h3>
          <dl className="cup-slot-facts">
            <div>
              <dt>{isChain ? 'Treasury prize' : 'Prize pool'}</dt>
              <dd className={prizeKnown ? 'is-prize' : undefined}>{prize}</dd>
            </div>
            <div>
              <dt>{isChain ? 'Burn fee' : 'Entry'}</dt>
              <dd>{entry}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd><span className={`cup-pill ${statusTone(status)}`}>{status}</span></dd>
            </div>
            <div>
              <dt>Field</dt>
              <dd>{fieldFull ? `${players} / ${maxPlayers} full` : `${players} / ${maxPlayers}`}</dd>
            </div>
          </dl>
          {action}
        </div>
      </article>
    );
  }

  return (
    <article className={`${className} cup-feature`}>
      {art}
      <div className="cup-feature-body">
        <div className="cup-crumbs">
          <span className="cup-kicker">{slot.when === 'CURRENT' ? 'Featured cup' : 'Up first'}</span>
          <span className={`cup-pill ${statusTone(status)}`}>
            {status === 'LIVE' ? <i className="cup-dot is-pulse" aria-hidden /> : null}
            {status}
          </span>
        </div>
        <div className="cup-feature-title">
          <h2 className="cup-title">{slot.title}</h2>
          <span className="cup-feature-theme">{slot.themeLabel}</span>
        </div>
        <div className="cup-chips">
          <span className="cup-chip"><CupIcon name="users" />{slot.format.teamModeLabel}</span>
          <span className="cup-chip">{maxPlayers} players</span>
          <span className="cup-chip">Single elimination</span>
          <span className="cup-chip">Best of 1</span>
        </div>
        <div className={`cup-prize-hero${prizeKnown ? '' : ' is-tbd'}`}>
          <small><CupIcon name="trophy" />{isChain ? 'Treasury prize' : 'Prize pool'}</small>
          <strong>{prize}</strong>
        </div>
        <div className="cup-feature-stats">
          <div className="cup-stat">
            <span><CupIcon name="coins" />{isChain ? 'Burn fee' : 'Entry'}</span>
            <strong>{entry}</strong>
          </div>
          <div className="cup-stat">
            <span><CupIcon name="users" />Field</span>
            <strong>{players} / {maxPlayers}</strong>
            <CupMeter value={players} max={maxPlayers} />
          </div>
          {countdownState && countdown ? (
            <div className="cup-stat">
              <span><CupIcon name="clock" />{countdownLabel}</span>
              <strong>{countdown}</strong>
            </div>
          ) : (
            <div className="cup-stat">
              <span><CupIcon name="clipboard" />Pool</span>
              <strong>{slot.format.restriction}</strong>
            </div>
          )}
        </div>
        <div className="cup-feature-cta">
          {action}
          {joinable && slotOpen && teamReady === false ? (
            <small>Save a legal {slot.title} team to enter</small>
          ) : null}
        </div>
      </div>
    </article>
  );
}
