'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

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

export default function TournamentsPage() {
  const { client, snapshot, refreshSnapshot, connected, walletConnected, connectInjectedWallet, connectingWallet, playerId, chainEconomyEnabled } = useArena();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <h1>Tournament schedule</h1>
          <p className="pa-lead">
            Preset Gen X, then that generation&apos;s custom cup, then Gen 9 OU. Automatic rotation starts only when enabled.
          </p>
        </div>
        <div className="pa-page-actions">
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

      <div className="pa-live-strip">
        <span className="pa-live-pill">
          <i /> {scheduler?.enabled
            ? scheduler.nextTournamentStartAt
              ? `Next tournament in ${formatCountdown(scheduler.nextTournamentStartAt, now ?? Date.now())}`
              : 'Scheduling enabled'
            : 'Scheduling OFF'}
        </span>
        {scheduler?.enabled && scheduler.nextTournamentStartAt ? (
          <span className="pa-strip-end">
            Starts {new Date(scheduler.nextTournamentStartAt).toLocaleString()}
          </span>
        ) : null}
        {!scheduler?.enabled ? <span className="pa-strip-end">No automatic tournament creation</span> : null}
      </div>

      <section className="pa-schedule">
        <div className="pa-schedule-list">
          {schedule.map(slot => (
            <ScheduleCard
              key={slot.key}
              slot={slot}
              now={now}
              scheduler={scheduler}
              busy={busy}
              chain={chain}
              teamReady={slot.format.teamMode === 'custom'
                ? Boolean(playerId && readSavedTeam(playerId, slot.rulesetId)?.validated
                  && readSavedTeam(playerId, slot.rulesetId)?.paste.trim())
                : null}
              onJoin={async () => {
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
              }}
            />
          ))}
        </div>
      </section>

      <section className="pa-mode-pair">
        <article className="pa-mode-panel casual">
          <header>
            <div>
              <small>Casual</small>
              <h3>Player-funded</h3>
            </div>
            <span>Collateral</span>
          </header>
          <p>
            {chain
              ? 'Each side posts SOL collateral. One 2% fee from the gross pool at match start.'
              : 'Each side posts POKE collateral. One 2% fee from the gross pool at settlement.'}
          </p>
          <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/arena">Open arena</Link>
        </article>
        <article className="pa-mode-panel cup">
          <header>
            <div>
              <small>Tournament</small>
              <h3>{chain ? 'Treasury-funded' : 'Field-funded'}</h3>
            </div>
            <span>{chain ? 'Burn fee' : 'Entry hold'}</span>
          </header>
          <p>
            {chain
              ? `${formatPokeFromAtoms(TOURNAMENT_BURN_FEE_ATOMS)} of POKE is burned after the field fills. The CARDS prize pays 1st 50%, 2nd 35%, and 3rd the remainder. A two-player final pays the winner the full prize.`
              : `${formatPoke(TOURNAMENT_ENTRY_POKE)} POKE is held at join. 90% of those entries form the prize pool, paid 50/35/15.`}
          </p>
          <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/treasury">See funding</Link>
        </article>
      </section>

      <div className="pa-soon">
        <span>Register</span>
        <span aria-hidden>→</span>
        <span>{roundLabel(1, schedule[0]?.maxPlayers ?? 32)}</span>
        <span aria-hidden>→</span>
        <span>Final</span>
        <span aria-hidden>→</span>
        <span>Champion</span>
      </div>
    </div>
  );
}

function ScheduleCard({
  slot,
  now,
  scheduler,
  busy,
  chain,
  teamReady,
  onJoin,
}: {
  slot: ScheduleSlot;
  now: number | null;
  scheduler: { enabled: boolean; nextTournamentStartAt?: number; nextRotationIndex: number } | undefined;
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

  return (
    <article className={`pa-schedule-card ${slot.kind} is-format is-${slot.format.accent}${isGen1Cup ? ' is-gen1' : ''}${joinable ? '' : ' is-upcoming'}${slot.isLocked ? ' is-locked' : ''}`}>
      <div className="pa-schedule-card-mark">
        <span>
          {slot.when}
        </span>
        <strong>{slot.title}</strong>
        <small>{slot.themeLabel}</small>
        <small>{slot.format.teamModeLabel} · {maxPlayers} PLAYERS</small>
      </div>

      {isGen1Cup ? (
        <Gen1CupArt compact />
      ) : (
        <FormatStage compact trainer={slot.format.trainer} pokemon={slot.format.pokemon} />
      )}

      {countdownState && countdown ? (
        <div className="pa-schedule-countdown-overlay" aria-label={`${countdownLabel} ${countdown}`}>
          <small>{countdownLabel}</small>
          <strong>{countdown}</strong>
        </div>
      ) : slot.isLocked ? (
        <div className="pa-schedule-countdown-overlay pa-schedule-lock-overlay" aria-label="Tournament locked">
          <ScheduleLockIcon large />
        </div>
      ) : null}

      <div className="pa-schedule-card-close">
        <div className="pa-schedule-prize">
          <small>{isChain ? 'Treasury prize' : 'Prize pool'}</small>
          <strong>
            <em>{prize}</em>
          </strong>
        </div>
        <dl className="pa-schedule-facts">
          <div>
            <dt>{isChain ? 'Burn fee' : 'Entry'}</dt>
            <dd>{entry}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className={`pa-schedule-status status-${status.toLowerCase()}`}>{status}</dd>
          </div>
          <div>
            <dt>Field</dt>
            <dd>{fieldFull ? `${players} / ${maxPlayers} players full` : `${players} / ${maxPlayers} players`}</dd>
          </div>
          {countdownState && countdown ? (
            <div>
              <dt>{countdownLabel}</dt>
              <dd>{countdown}</dd>
            </div>
          ) : null}
        </dl>
        {!joinable && status === 'ROTATION PREVIEW' ? (
          <button type="button" className="pa-btn pa-btn-surface" disabled>
            Rotation preview
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
        )}
      </div>
    </article>
  );
}

function ScheduleLockIcon({ large = false }: { large?: boolean }) {
  return (
    <svg
      className={large ? 'pa-schedule-lock-icon is-large' : 'pa-schedule-lock-icon'}
      width="0.8em"
      height="0.8em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Locked"
      role="img"
    >
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
